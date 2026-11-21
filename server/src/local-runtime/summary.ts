import type { createLocalRuntimeStore } from "./store";

type LocalRuntimeStore = ReturnType<typeof createLocalRuntimeStore>;

/**
 * The history read `readHistory` returns, named once so the derivation and its callers state one
 * shape instead of restating the store's return type.
 */
export type LocalHistory = Awaited<
  ReturnType<LocalRuntimeStore["readHistory"]>
>;

export type LocalRunStatus =
  | { phase: "idle" }
  | { phase: "queued" | "running"; runId: string }
  | { phase: "succeeded"; runId: string }
  | { phase: "failed"; runId: string; reason: string }
  | { phase: "interrupted"; runId: string; reason: string };

/**
 * A terminal run row and a terminal `attempt.*` event that disagree, or a terminal run without its
 * event. Every writer pairs them in one transaction (`finishAttempt`, `settleLapsedThreadWork`), so
 * a disagreeing pair means a writer defect or a hand edit, not a state any consumer should be shown.
 * The derivation throws rather than guess a phase, and the status route lets the throw surface as
 * the app's own 500 instead of the not-found answer the ownership boundary owns.
 */
export class LocalRunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalRunStateError";
  }
}

type TerminalAttemptEventType =
  | "attempt.succeeded"
  | "attempt.failed"
  | "attempt.interrupted";

function terminalEventFor(
  status: string,
): TerminalAttemptEventType | undefined {
  if (status === "succeeded") return "attempt.succeeded";
  if (status === "failed") return "attempt.failed";
  if (status === "cancelled") return "attempt.interrupted";
  return undefined;
}

function isTerminalAttemptEvent(
  type: string,
): type is TerminalAttemptEventType {
  return (
    type === "attempt.succeeded" ||
    type === "attempt.failed" ||
    type === "attempt.interrupted"
  );
}

function eventReason(payload: Record<string, unknown>): string | undefined {
  const reason = payload.reason;
  return typeof reason === "string" && reason ? reason : undefined;
}

/**
 * `finishAttempt` can fail or interrupt a run without storing a reason anywhere. The derivation
 * stays total with the same sentence the RUN_ERROR write of that shape emits, so it never invents
 * a second voice for one outcome.
 */
const failedWithoutReason = "Local Agent run failed.";
const stoppedWithoutReason = "Run stopped by user";

function checkedTerminalEvent(
  run: LocalHistory["runs"][number],
  events: readonly LocalHistory["events"][number][],
  expected: TerminalAttemptEventType,
) {
  const terminal = events.filter(
    (event) => event.runId === run.id && isTerminalAttemptEvent(event.type),
  );
  const event = terminal.at(-1);
  if (terminal.length !== 1 || !event || event.type !== expected) {
    throw new LocalRunStateError(
      `Local run ${run.id} is "${run.status}" but its recorded terminal events are [${terminal
        .map((row) => row.type)
        .join(", ")}].`,
    );
  }
  return event;
}

/**
 * Derive a thread's run status from its history read, so the UI, the evidence scripts, and the
 * reconnect journey read one function instead of agreeing by convention.
 *
 * The phase comes from the newest run row (readHistory orders runs by creation, so the newest is
 * the last row) checked against the run's exactly-one agreeing terminal `attempt.*` event. A
 * `cancelled` run therefore reads as interrupted, and a `failed` one carries the stored
 * `local_runs.error`. Pure over the read: no client state, no clock, no store call.
 *
 * The agreeing-pair invariant is enforced for every terminal run in the read, not only the newest
 * one, because this derivation is the one place that reads runs and events together and a defect
 * in any stored pair is a defect in the thread's storage.
 */
export function summarizeRunState(history: LocalHistory): LocalRunStatus {
  for (const run of history.runs) {
    const expected = terminalEventFor(run.status);
    if (expected) checkedTerminalEvent(run, history.events, expected);
  }

  const run = history.runs.at(-1);
  if (!run) return { phase: "idle" };
  if (run.status === "queued" || run.status === "running") {
    return { phase: run.status, runId: run.id };
  }

  const expected = terminalEventFor(run.status);
  // Unreachable for a row the loop above already accepted, kept so an unknown status still fails
  // closed if the loop is ever removed.
  if (!expected) {
    throw new LocalRunStateError(
      `Local run ${run.id} has unrecognized status "${run.status}".`,
    );
  }
  const event = checkedTerminalEvent(run, history.events, expected);
  switch (expected) {
    case "attempt.succeeded":
      return { phase: "succeeded", runId: run.id };
    case "attempt.failed":
      return {
        phase: "failed",
        runId: run.id,
        reason: run.error ?? failedWithoutReason,
      };
    case "attempt.interrupted":
      return {
        phase: "interrupted",
        runId: run.id,
        reason: eventReason(event.payload) ?? stoppedWithoutReason,
      };
    default: {
      const _exhaustive: never = expected;
      return _exhaustive;
    }
  }
}
